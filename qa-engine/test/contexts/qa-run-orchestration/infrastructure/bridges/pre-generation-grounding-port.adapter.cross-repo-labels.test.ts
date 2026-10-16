/* A service repo's diff says nothing about the labels of the front end's pages. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PreGenerationGroundingPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.ts";

type PackInput = { changedLiterals?: unknown[]; changedElements?: Array<{ text?: string; testId?: string }> };

const serviceDiff = [
  "diff --git a/src/main/resources/messages.properties b/src/main/resources/messages.properties",
  "--- a/src/main/resources/messages.properties",
  "+++ b/src/main/resources/messages.properties",
  "@@ -1,1 +1,2 @@",
  " a=b",
  '+label = "Cambiar filtros"',
  "diff --git a/src/main/resources/templates/mail.html b/src/main/resources/templates/mail.html",
  "--- a/src/main/resources/templates/mail.html",
  "+++ b/src/main/resources/templates/mail.html",
  "@@ -1,1 +1,2 @@",
  " <p>",
  '+<button data-cy="send">Enviar</button>',
].join("\n");

async function packInputFor(statics: { stagedRoots?: string[] }): Promise<PackInput> {
  let seen: PackInput = {};
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e", ...statics },
    { buildContextPack: async (input) => { seen = input as PackInput; return { text: undefined, domBytes: 0, contractBytes: 0 }; } },
  );
  await adapter.ground("/tmp/qa-golden/e2e", undefined, serviceDiff, { sha: "abc1234" });
  return seen;
}

test("ground(): a single-repo run states the quoted labels of its diff", async () => {
  const input = await packInputFor({});
  assert.equal(input.changedLiterals?.length, 1);
  assert.ok(input.changedElements?.some((e) => e.text === "Cambiar filtros"));
});

test("ground(): a cross-repo run takes no label of the service's diff, neither a pack literal nor a text mark, and keeps the element it can tie to an attribute", async () => {
  const input = await packInputFor({ stagedRoots: [] });
  assert.equal("changedLiterals" in input, false);
  assert.equal((input.changedElements ?? []).some((e) => e.text === "Cambiar filtros"), false);
  assert.ok((input.changedElements ?? []).some((e) => e.testId === "send"));
});
