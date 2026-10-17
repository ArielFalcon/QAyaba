import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ATTRIBUTES, ATTRIBUTE_TEMPLATES, lookupAttribute, attrKey, type Attrs } from "@kernel/telemetry/attribute-registry.ts";
import { GENAI, GENAI_SEMCONV_REV } from "@kernel/telemetry/genai-semconv.ts";

test("a plain registered key resolves to its spec", () => {
  const spec = lookupAttribute("qayaba.run.id");
  assert.ok(spec);
  assert.equal(spec.cardinality, "high");
  assert.equal(spec.content, "none");
});

test("an unregistered key does not resolve", () => {
  assert.equal(lookupAttribute("qayaba.not.a.key"), undefined);
  assert.equal(lookupAttribute(""), undefined);
});

test("a template key resolves when the variable segment is a single plain segment", () => {
  assert.ok(lookupAttribute("qayaba.prompt.section.recent-failures.bytes"));
  assert.ok(lookupAttribute("qayaba.prompt.section.recent-failures.hash"));
  assert.ok(lookupAttribute("qayaba.campaign.variant.closed_loop"));
  assert.ok(lookupAttribute("qayaba.agent.calls.read"));
});

test("a template key does not match across dots or with an empty variable segment", () => {
  assert.equal(lookupAttribute("qayaba.prompt.section.a.b.bytes"), undefined);
  assert.equal(lookupAttribute("qayaba.prompt.section..bytes"), undefined);
  assert.equal(lookupAttribute("qayaba.prompt.section.x.other"), undefined);
});

test("template key builders produce keys the registry resolves", () => {
  for (const key of [attrKey.promptSectionBytes("grounding"), attrKey.promptSectionHash("grounding"), attrKey.campaignVariant("k"), attrKey.agentCalls("read")]) {
    assert.ok(lookupAttribute(key), key);
  }
});

test("every registered key and template carries a described, classified spec", () => {
  const specs = [...Object.values(ATTRIBUTES), ...ATTRIBUTE_TEMPLATES.map((t) => t.spec)];
  assert.ok(specs.length > 40);
  for (const spec of specs) {
    assert.ok(spec.description.length > 0);
    assert.ok(["low", "high"].includes(spec.cardinality));
    assert.ok(["none", "metadata", "redacted-text", "content"].includes(spec.content));
  }
});

test("every gen_ai key the semconv module spells is registered, and the revision is recorded", () => {
  for (const key of Object.values(GENAI.attrs)) assert.ok(lookupAttribute(key), key);
  assert.match(GENAI_SEMCONV_REV, /^main@\d{4}-\d{2}-\d{2}$/);
});

test("message content keys are classified as content so they drop below full capture", () => {
  assert.equal(lookupAttribute(GENAI.attrs.inputMessages)?.content, "content");
  assert.equal(lookupAttribute(GENAI.attrs.outputMessages)?.content, "content");
});

test("only the semconv module spells a gen_ai key in telemetry sources", () => {
  const roots = [join(import.meta.dirname, "../../../src/shared-kernel/telemetry"), join(import.meta.dirname, "../../../../src/telemetry")];
  for (const root of roots) {
    for (const file of readdirSync(root).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      if (file === "genai-semconv.ts") continue;
      assert.ok(!readFileSync(join(root, file), "utf8").includes("gen_ai."), `${file} spells a gen_ai key`);
    }
  }
});

test("an unregistered literal key fails to compile, a registered and a template key do not", () => {
  const ok: Attrs = { "qayaba.app": "shop", "qayaba.prompt.section.grounding.bytes": 4, "qayaba.agent.calls.read": 2 };
  // @ts-expect-error "qayaba.not.a.key" is not in the registry
  const bad: Attrs = { "qayaba.not.a.key": "x" };
  assert.ok(ok && bad);
});
