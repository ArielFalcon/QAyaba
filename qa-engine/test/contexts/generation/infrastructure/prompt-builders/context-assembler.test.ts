/* Covers: canonical ordering, per-section byte cap enforcement,
   scaffold-vs-verbatim language handling, section_sizes output,
   logs the action, and preserves higher-priority sections intact.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assemble, section, Section } from "@contexts/generation/infrastructure/prompt-builders/context-assembler.ts";
import { createRunSecretScope, redactByValue, withRunSecretScope } from "../../../../../src/shared-kernel/run-secret-redaction.ts";

test("assemble: sections are emitted in canonical role order regardless of input order", () => {
  const sections: Section[] = [
    section("task", "task", "## TASK\nconcrete objective"),
    section("working-rules", "stable-prefix", "## Working rules\ndo good work"),
    section("critical-recap", "critical-recap", "## Critical recap\nDO NOT hallucinate"),
    section("diff", "semi-stable", "## Diff\n+x"),
    section("dom", "volatile", "## DOM\nbutton: Submit"),
  ];
  const { text } = assemble(sections);

  const wpIdx = text.indexOf("Working rules");
  const diffIdx = text.indexOf("## Diff");
  const domIdx = text.indexOf("## DOM");
  const taskIdx = text.indexOf("## TASK");
  const recapIdx = text.indexOf("## Critical recap");

  assert.ok(wpIdx < diffIdx, "stable-prefix must come before semi-stable");
  assert.ok(diffIdx < domIdx, "semi-stable must come before volatile");
  assert.ok(domIdx < taskIdx, "volatile must come before task");
  assert.ok(taskIdx < recapIdx, "task must come before critical-recap");
});

test("assemble: priority within same role determines sub-order", () => {
  const sections: Section[] = [
    section("rule-b", "stable-prefix", "RULE_B", { priority: 2 }),
    section("rule-a", "stable-prefix", "RULE_A", { priority: 1 }),
    section("rule-c", "stable-prefix", "RULE_C", { priority: 3 }),
  ];
  const { text } = assemble(sections);
  const aIdx = text.indexOf("RULE_A");
  const bIdx = text.indexOf("RULE_B");
  const cIdx = text.indexOf("RULE_C");
  assert.ok(aIdx < bIdx, "priority 1 before priority 2");
  assert.ok(bIdx < cIdx, "priority 2 before priority 3");
});

test("assemble: TASK section index is after VOLATILE and before CRITICAL recap", () => {
  const sections: Section[] = [
    section("recap", "critical-recap", "RECAP_SENTINEL"),
    section("obj", "task", "TASK_SENTINEL"),
    section("dom-s", "volatile", "VOLATILE_SENTINEL"),
    section("rules", "stable-prefix", "STABLE_SENTINEL"),
    section("arch", "semi-stable", "SEMI_SENTINEL"),
  ];
  const { text } = assemble(sections);
  const volatileIdx = text.indexOf("VOLATILE_SENTINEL");
  const taskIdx = text.indexOf("TASK_SENTINEL");
  const recapIdx = text.indexOf("RECAP_SENTINEL");

  assert.ok(volatileIdx < taskIdx, "volatile comes before task");
  assert.ok(taskIdx < recapIdx, "task comes before critical-recap");
});

test("assemble: content within maxBytes is passed through unchanged", () => {
  const content = "A".repeat(100);
  const s = section("s", "task", content, { maxBytes: 500 });
  const { text, sectionSizes } = assemble([s]);
  assert.equal(text, content);
  assert.equal(sectionSizes["s"], Buffer.byteLength(content, "utf8"));
});

test("assemble: content exceeding maxBytes is truncated with a visible marker (overflow=summarize)", () => {
  const longContent = "X".repeat(1000);
  const maxBytes = 50;
  const s = section("reviewer-corrections", "volatile", longContent, { maxBytes, overflow: "summarize" });
  const { text, sectionSizes } = assemble([s]);

  /* The capped output must be shorter than the original. */
  assert.ok(Buffer.byteLength(text, "utf8") < Buffer.byteLength(longContent, "utf8"));
  /* The marker must be present so the operator can see it was capped. */
  assert.match(text, /capped at 50 bytes/);
  /* The sectionSizes entry must reflect the actual (capped) byte count. */
  const reportedSize = sectionSizes["reviewer-corrections"]!;
  assert.ok(reportedSize > 0);
  /* The reported size must be less than the original content's byte length. */
  assert.ok(reportedSize < Buffer.byteLength(longContent, "utf8"), "capped section size must be less than original");
  /* The total assembled text byte length must match reported size (single section). */
  assert.equal(reportedSize, Buffer.byteLength(text, "utf8"));
});

/* #6 regression: a cap that lands in the MIDDLE of a multi-byte UTF-8 sequence must not inject a
   U+FFFD replacement char, and the truncated content must be a TRUE byte ceiling (≤ maxBytes).
   "€" is 3 bytes (E2 82 AC); maxBytes=10 lands on the 4th char's lead byte (bytes 0-8 = 3 chars,
   byte 9 = start of the 4th) → the partial lead byte must be dropped, leaving 9 valid bytes.
 */
test("assemble: a cap at a mid-multibyte boundary yields valid UTF-8 (no U+FFFD) within the ceiling", () => {
  const content = "€".repeat(20); /* 60 bytes of 3-byte chars */
  const maxBytes = 10;
  const { text, sectionSizes } = assemble([section("reviewer-corrections", "volatile", content, { maxBytes, overflow: "summarize" })]);

  assert.doesNotMatch(text, /�/, "no U+FFFD replacement char may appear");

  const markerIdx = text.indexOf("\n…(section");
  assert.ok(markerIdx > 0, "the cap marker must be appended");
  const truncatedContent = text.slice(0, markerIdx);

  assert.ok(
    Buffer.byteLength(truncatedContent, "utf8") <= maxBytes,
    `truncated content (${Buffer.byteLength(truncatedContent, "utf8")} bytes) must be ≤ maxBytes (${maxBytes})`,
  );
  assert.equal(truncatedContent, "€€€", "exactly 3 whole '€' chars (9 bytes) fit under a 10-byte cap");
  assert.equal(sectionSizes["reviewer-corrections"], Buffer.byteLength(text, "utf8"));
});

test("assemble: maxBytes=0 means uncapped (no truncation)", () => {
  const longContent = "Y".repeat(100_000);
  const s = section("diff", "semi-stable", longContent, { maxBytes: 0, language: "verbatim" });
  const { text, sectionSizes } = assemble([s]);
  assert.equal(text, longContent);
  assert.equal(sectionSizes["diff"], Buffer.byteLength(longContent, "utf8"));
});

/* an overflow="drop" section that exceeds maxBytes must be OMITTED entirely — never
   truncated mid-content (a half-cut instruction can read as a DIFFERENT instruction). This is
   the policy the production reviewer-corrections section declares (prompts.ts).
 */
test("assemble: an overflow='drop' section over budget is omitted entirely (not truncated)", () => {
  const longContent = "Z".repeat(1000);
  const maxBytes = 50;
  const dropped = section("reviewer-corrections", "volatile", longContent, { maxBytes, overflow: "drop" });
  /* A neighbouring task section proves the assembler keeps going after a drop. */
  const keep = section("task", "task", "## TASK\nthe objective");
  const { text, sectionSizes } = assemble([dropped, keep]);

  assert.ok(!text.includes("Z"), "dropped section content must not appear");
  assert.doesNotMatch(text, /capped at 50 bytes/, "a dropped section must not emit a truncation marker");
  assert.ok(!("reviewer-corrections" in sectionSizes), "a dropped section must be absent from sectionSizes");
  assert.ok(text.includes("## TASK"), "non-overflowing sections must still be assembled");
  assert.ok("task" in sectionSizes, "the kept section must be in sectionSizes");
});

/* fires on overflow, never on in-budget content). */
test("assemble: an overflow='drop' section within budget is passed through unchanged", () => {
  const content = "within budget";
  const s = section("reviewer-corrections", "volatile", content, { maxBytes: 500, overflow: "drop" });
  const { text, sectionSizes } = assemble([s]);
  assert.equal(text, content, "in-budget drop section must be emitted verbatim");
  assert.equal(sectionSizes["reviewer-corrections"], Buffer.byteLength(content, "utf8"));
});

/* (the documented fallback) — same observable behaviour as before this fix for that policy. */
test("assemble: an overflow='summarize' section over budget is truncated with a marker (degraded fallback)", () => {
  const longContent = "W".repeat(1000);
  const maxBytes = 40;
  const s = section("reviewer-corrections", "volatile", longContent, { maxBytes, overflow: "summarize" });
  const { text, sectionSizes } = assemble([s]);
  assert.match(text, /capped at 40 bytes/, "summarize must fall back to truncation-with-marker");
  assert.ok("reviewer-corrections" in sectionSizes, "a truncated section is still emitted (present in sectionSizes)");
  assert.ok(sectionSizes["reviewer-corrections"]! < Buffer.byteLength(longContent, "utf8"));
});

test("assemble: scaffold and verbatim sections coexist without modification", () => {
  /* The assembler itself does NOT translate content (the assembler tags
     sections, it does not transform them). The test asserts the language tag is respected:
     verbatim sections reach the output byte-for-byte (beyond cap), scaffold sections do too.
   */
  const verbatimContent = "Contenido de usuario: comprobar el formulario de registro";
  const scaffoldContent = "## Working rules\nDo not navigate routes you have not explored.";

  const sections: Section[] = [
    section("user-guidance", "volatile", verbatimContent, { language: "verbatim" }),
    section("working-rules", "stable-prefix", scaffoldContent, { language: "scaffold" }),
  ];
  const { text } = assemble(sections);

  /* Both sections reach the output unmodified (the assembler does not translate). */
  assert.ok(text.includes(verbatimContent), "verbatim user content must appear unchanged");
  assert.ok(text.includes(scaffoldContent), "scaffold content must appear unchanged");
});

test("assemble: sectionSizes maps every non-empty section id to its byte length", () => {
  const sections: Section[] = [
    section("a", "stable-prefix", "AAA"),
    section("b", "semi-stable", "BB"),
    section("c", "volatile", "CCCCC"),
    section("d", "task", "DDDD"),
    section("e", "critical-recap", "EE"),
  ];
  const { sectionSizes } = assemble(sections);

  assert.equal(sectionSizes["a"], 3);
  assert.equal(sectionSizes["b"], 2);
  assert.equal(sectionSizes["c"], 5);
  assert.equal(sectionSizes["d"], 4);
  assert.equal(sectionSizes["e"], 2);
});

test("assemble: empty sections are omitted from sectionSizes", () => {
  const sections: Section[] = [
    section("present", "task", "content"),
    section("empty", "volatile", ""),
  ];
  const { sectionSizes } = assemble(sections);

  assert.ok("present" in sectionSizes, "non-empty section must be in sectionSizes");
  assert.ok(!("empty" in sectionSizes), "empty section must be omitted from sectionSizes");
});

test("assemble: sectionSizes byte counts match actual assembled content lengths", () => {
  const emoji = "🚀";
  const s = section("emoji-section", "task", emoji);
  const { text, sectionSizes } = assemble([s]);
  assert.equal(sectionSizes["emoji-section"], Buffer.byteLength(emoji, "utf8"));
  assert.equal(Buffer.byteLength(text, "utf8"), Buffer.byteLength(emoji, "utf8"));
});

test("assemble: content can be a lazy producer function (resolved at assembly time)", () => {
  let calls = 0;
  const producer = () => {
    calls++;
    return "PRODUCED_CONTENT";
  };
  const s = section("lazy", "task", producer);
  const { text } = assemble([s]);
  assert.equal(calls, 1, "producer must be called exactly once");
  assert.ok(text.includes("PRODUCED_CONTENT"));
});

test("section() helper fills in sensible defaults", () => {
  const s = section("x", "task", "content");
  assert.equal(s.priority, 0);
  assert.equal(s.maxBytes, 0);
  assert.equal(s.stability, "run");
  assert.equal(s.overflow, "drop");
  assert.equal(s.language, "scaffold");
});

test("section() helper accepts explicit overrides", () => {
  const s = section("x", "volatile", "content", {
    priority: 5,
    maxBytes: 1000,
    stability: "static",
    overflow: "summarize",
    language: "verbatim",
  });
  assert.equal(s.priority, 5);
  assert.equal(s.maxBytes, 1000);
  assert.equal(s.stability, "static");
  assert.equal(s.overflow, "summarize");
  assert.equal(s.language, "verbatim");
});

test("assemble: a realistic multi-section prompt has canonical structure", () => {
  const sections: Section[] = [
    section("engram-rule", "stable-prefix", "engram: scoped per app", { priority: 10 }),
    section("playwright-rules", "stable-prefix", "## Working rules\nPrefer getByRole.", { priority: 5 }),
    section("diff", "semi-stable", "```diff\n+new feature\n```", { language: "verbatim" }),
    section("arch-map", "semi-stable", "## Architecture context\nroutes: /checkout", { priority: 2 }),
    section("dom-snapshot", "volatile", "## Live DEV DOM\nbutton: Submit", { priority: 1 }),
    section("review-corrections", "volatile", "## Reviewer corrections\n- fix selector", { priority: 2 }),
    section("objective", "task", "## Objective\nconfirm user sees discount", { priority: 1 }),
    section("acceptance-rule", "task", "MUST fail if regression", { priority: 2 }),
    section("critical-bottom", "critical-recap", "## Critical recap\nWRITE the file."),
  ];

  const { text, sectionSizes } = assemble(sections);

  const stableIdx = text.indexOf("Working rules");
  const archIdx = text.indexOf("Architecture context");
  const domIdx = text.indexOf("Live DEV DOM");
  const correctionsIdx = text.indexOf("Reviewer corrections");
  const objectiveIdx = text.indexOf("## Objective");
  const recapIdx = text.indexOf("## Critical recap");

  assert.ok(stableIdx < archIdx, "stable-prefix before semi-stable");
  assert.ok(archIdx < domIdx, "semi-stable before volatile");
  assert.ok(domIdx < objectiveIdx, "volatile before task");
  assert.ok(correctionsIdx < objectiveIdx, "corrections (volatile) before task");
  assert.ok(objectiveIdx < recapIdx, "task before critical-recap");

  const expectedIds = [
    "engram-rule", "playwright-rules", "diff", "arch-map",
    "dom-snapshot", "review-corrections", "objective", "acceptance-rule", "critical-bottom",
  ];
  for (const id of expectedIds) {
    assert.ok(id in sectionSizes, `sectionSizes must contain '${id}'`);
    assert.ok(sectionSizes[id]! > 0, `sectionSizes['${id}'] must be > 0`);
  }
});

test("assemble: no sum of section sizes sheds or truncates a section: a prompt of any size is assembled whole", () => {
  const sections = [
    section("rules", "stable-prefix", "RULES"),
    section("big", "volatile", "A".repeat(1_000_000), { overflow: "summarize" }),
    section("bigger", "volatile", "B".repeat(1_000_000), { overflow: "drop", priority: 3 }),
    section("task", "task", "TASK"),
  ];
  const { text, sectionSizes, sectionItems } = assemble(sections);
  assert.deepEqual(Object.keys(sectionSizes), ["rules", "big", "bigger", "task"]);
  assert.equal(sectionSizes["big"], 1_000_000);
  assert.equal(sectionSizes["bigger"], 1_000_000);
  assert.ok(text.endsWith("TASK") && text.startsWith("RULES"));
  assert.doesNotMatch(text, /Budget|omitted|capped at/);
  assert.deepEqual(sectionItems, {});
});

/* Claims: builders declare what a section provides, frames or directs; the assembler reports only what survived. */
test("assemble: claims of the surviving sections are reported by section id", () => {
  const rulesClaims = [{ kind: "directs", action: "state-outcome" }] as const;
  const domClaims = [{ kind: "provides", fact: "dom-live" }] as const;
  const { claims } = assemble([
    section("rules", "stable-prefix", "RULES", { claims: rulesClaims }),
    section("dom", "volatile", "DOM", { claims: domClaims }),
    section("plain", "task", "PLAIN"),
  ]);
  assert.deepEqual(claims, { rules: rulesClaims, dom: domClaims });
});

test("assemble: a section dropped for exceeding its own cap contributes no claims", () => {
  const { claims } = assemble([
    section("huge", "volatile", "H".repeat(500), {
      maxBytes: 100,
      overflow: "drop",
      claims: [{ kind: "provides", fact: "dom-live" }],
    }),
  ]);
  assert.deepEqual(claims, {});
});

/* A grounding section the assembler capped or shed delivers no item ids, and says so with the right omission. */
test("assemble: a capped grounding section delivers no item ids and counts the cap as an omission", () => {
  const { sectionItems } = assemble([
    section("context-pack", "volatile", "X".repeat(1000), {
      priority: 0,
      maxBytes: 50,
      overflow: "summarize",
      itemIds: ["dom:/a#b"],
      omissions: [{ class: "truncation", reason: "node-cap", count: 3 }],
    }),
  ]);
  assert.deepEqual(sectionItems["context-pack"], {
    itemIds: [],
    omissions: [
      { class: "truncation", reason: "node-cap", count: 3 },
      { class: "truncation", reason: "section-cap", count: 1 },
    ],
    capped: true,
  });
});

test("assemble: a grounding section dropped for exceeding its own cap delivers no item ids and counts the drop as an omission", () => {
  const { sectionItems } = assemble([
    section("context-pack", "volatile", "Y".repeat(400), { priority: 0, maxBytes: 100, overflow: "drop", itemIds: ["dom:/a#b"] }),
    section("task", "task", "TASK"),
  ]);
  assert.deepEqual(sectionItems["context-pack"], {
    itemIds: [],
    omissions: [{ class: "truncation", reason: "section-shed", count: 1 }],
    capped: false,
  });
});

/* Hashes: one per surviving section, over its bytes with the run's secrets taken out. The whole prompt's hash is the transport's, over what it sends. */
test("assemble: every surviving section has a sha256 of its bytes", () => {
  const { sectionHashes } = assemble([section("rules", "stable-prefix", "RULES"), section("task", "task", "TASK")]);
  assert.equal(sectionHashes?.["rules"], createHash("sha256").update("RULES", "utf8").digest("hex"));
  assert.ok(sectionHashes?.["task"]);
});

test("assemble: a changed section changes its own hash and no other section's", () => {
  const before = assemble([section("rules", "stable-prefix", "RULES"), section("task", "task", "TASK one")]);
  const after = assemble([section("rules", "stable-prefix", "RULES"), section("task", "task", "TASK two")]);
  assert.equal(before.sectionHashes?.["rules"], after.sectionHashes?.["rules"]);
  assert.notEqual(before.sectionHashes?.["task"], after.sectionHashes?.["task"]);
});

test("assemble: a section dropped for exceeding its own cap has no hash", () => {
  const dropped = assemble([section("rules", "stable-prefix", "RULES"), section("dom", "volatile", "D".repeat(400), { maxBytes: 100, overflow: "drop" })]);
  assert.equal(dropped.sectionHashes?.["dom"], undefined);
  assert.ok(dropped.sectionHashes?.["rules"]);
});

test("assemble: the hash of a section that carries a run secret equals the hash of the redacted section, and the secret leaves no trace in it", () => {
  const secrets = createRunSecretScope();
  secrets.addAccountSecrets(["hunter2-pass"]);
  const withSecret = withRunSecretScope(secrets, () => assemble([section("task", "task", "log in with hunter2-pass please")]));
  const redactedSection = withRunSecretScope(secrets, () => redactByValue("log in with hunter2-pass please"));
  assert.ok(!redactedSection.includes("hunter2"));
  assert.equal(withSecret.sectionHashes?.["task"], createHash("sha256").update(redactedSection, "utf8").digest("hex"));
  assert.ok(!JSON.stringify(withSecret.sectionHashes).includes("hunter2"));
  /* The text itself is untouched: the transport redacts it at the last seam, as it always did. */
  assert.match(withSecret.text, /hunter2-pass/);
});
